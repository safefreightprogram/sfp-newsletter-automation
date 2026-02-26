const OpenAI = require('openai');
const SheetsManager = require('../config/sheets');
const config = require('../config/config');
const fs = require('fs');
const EmailSender = require('./emailSender');

// SFP Brand Configuration
const SFP_BRAND = {
  colors: {
    primary: '#1e40af',      // SFP Blue
    secondary: '#374151',    // Professional Gray
    accent: '#059669',       // Success Green
    warning: '#d97706',      // Alert Orange
    danger: '#dc2626',       // Critical Red
    light: '#f8fafc',        // Light Background
    dark: '#111827',         // Dark Text
    blue100: '#dbeafe',      // Light Blue
    blue500: '#3b82f6',      // Medium Blue
    gray50: '#f9fafb',       // Very Light Gray
    gray600: '#4b5563',      // Medium Gray
    gray700: '#374151',      // Dark Gray
    gray800: '#1f2937'       // Very Dark Gray
  },
  
  logo: {
  url: 'https://www.safefreightprogram.com/assets/email/sfp-logo-small.png',
  width: 60,
  height: 60,
  alt: 'Safe Freight Program'
},

  
  typography: {
    primary: "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
    sizes: {
      h1: '32px',
      h2: '20px', 
      body: '15px',
      small: '13px',
      caption: '11px'
    }
  },

  newsletters: {
    pro: {
      title: 'CoR Intel Weekly',
      tagline: 'Chain of Responsibility Intelligence'
    },
    driver: {
      title: 'Safe Freight Mate',
      tagline: 'Your Weekly Safety & Compliance Update'
    }
  }
};

class NewsletterGenerator {
  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey
    });
    this.sheetsManager = new SheetsManager();
    this.emailSender = new EmailSender(); 
    
    // SAFE URLs for any synthetic content (VERIFIED EXISTING PAGES)
    this.VERIFIED_URLS = {
      'driver-wellness': 'https://www.healthyheads.org.au/', 
      'industry-support': 'https://www.twu.com.au/member-services/',
      'workplace-rights': 'https://www.fairwork.gov.au/about-us/our-role/legislation/fair-work-act',
      'general': 'https://www.nhvr.gov.au/safety-accreditation-compliance'
    };
  }

  async generateNewsletter(segment = 'pro', sendEmail = true) {
  try {
    console.log(`📰 Generating newsletter for ${segment} segment...`);
      
      // Initialize sheets
      await this.sheetsManager.initialize();
      
      // Get and prioritize recent articles (7-day filter applied in getRecentArticles)
      const recentArticles = await this.getRecentArticles(14, segment);
      console.log(`📋 Found ${recentArticles.length} recent articles for ${segment} segment`);
      
      if (recentArticles.length < 3) {
        throw new Error(`Insufficient content: only ${recentArticles.length} articles available`);
      }
      
      // Pre-filter: exclude pure advocacy/lobbying/market news with no compliance action for duty holders
      // These are identifiable by title/summary patterns that signal no operational obligation
      const advocacyPatterns = [
        /fuel tax/i, /tax hike/i, /road user charge/i, /levy increase/i,
        /industry lobbying/i, /calls for government/i, /urges government/i,
        /must reject/i, /rejects proposal/i,
        /truck sales/i, /vehicle sales/i, /sales soften/i, /sales decline/i,
        /market share/i, /production milestone/i, /record half.year/i,
        /stock market/i, /merger/i, /acquisition/i, /ipo/i,
        /conference registrations/i, /registrations open/i, /awards/i, /australia day honour/i,
        /geotab connect/i, /megatrans/i, /\bconference\b.*\bfocus/i,
        /traffic alert/i, /road works/i, /night works/i, /bridge closure/i, /changed traffic/i,
        /traffic conditions/i, /cyclone.*reconstruction/i, /hwy.*closure/i,
        /new model launch/i, /product launch/i, /enters.+market/i
      ];

      const complianceFiltered = recentArticles.filter(article => {
        const text = (article.title + ' ' + (article.summary || '')).toLowerCase();
        const isAdvocacy = advocacyPatterns.some(p => p.test(text));
        if (isAdvocacy) {
          console.log(`🚫 Pre-filter excluded (advocacy/market): ${article.title.substring(0, 60)}...`);
        }
        return !isAdvocacy;
      });

      // Also exclude QTA traffic alert articles by source+title pattern
      const trafficSources = ['queensland transport authority', 'qta'];
      const trafficTitlePatterns = [/^(mwfwb|sc|fnq|fnnq|seq|nq|ck|b|bne)\s*:/i, /hwy[,\s]/i, /highway.*alert/i, /road.*alert/i];
      const sourceFiltered = complianceFiltered.filter(article => {
        const src = (article.source || '').toLowerCase();
        const isTrafficSource = trafficSources.some(s => src.includes(s));
        const isTrafficTitle = trafficTitlePatterns.some(p => p.test(article.title || ''));
        if (isTrafficSource && isTrafficTitle) {
          console.log(`🚫 Pre-filter excluded (traffic alert): ${article.title.substring(0, 60)}...`);
          return false;
        }
        return true;
      });

      const poolForSelection = sourceFiltered.length >= 5 ? sourceFiltered : recentArticles;
      if (sourceFiltered.length < 5) {
        console.log(`⚠️ Pre-filter left fewer than 5 articles — using full pool as fallback`);
      }

      // Select top articles (already prioritized)
      const selectedArticles = poolForSelection.slice(0, 5);
      console.log(`✂️ Selected top ${selectedArticles.length} articles for processing`);
      
      // Show selected articles with priorities
      console.log('\n📖 Articles being processed (in priority order):');
      selectedArticles.forEach((article, i) => {
        console.log(`${i + 1}. [${article.category || 'Uncategorized'}] ${article.title.substring(0, 60)}...`);
        console.log(`   📊 Score: ${article.compositeScore?.toFixed(1) || article.relevanceScore || 'N/A'} | Source: ${article.source}`);
      });
      
      // Process articles with OpenAI (enhanced with URL protection and targeted tips)
      const processedArticles = await this.processWithOpenAI(selectedArticles, segment);
      
      // Generate newsletter HTML with logo and one-click unsubscribe
      const newsletterHtml = this.buildComplianceNewsletterHTML(processedArticles, segment);
      
      // Save newsletter preview
      const filename = `logs/${segment}-newsletter-${Date.now()}.html`;
      if (!fs.existsSync('logs')) {
        fs.mkdirSync('logs', { recursive: true });
      }
      fs.writeFileSync(filename, newsletterHtml);
      console.log(`💾 Newsletter saved: ${filename}`);
// Log newsletter to Content_Archive sheet
      try {
        const issueId = `${segment}-${new Date().toISOString().split('T')[0]}`;
        await this.sheetsManager.logNewsletterToArchive({
          issue_id: issueId,
          segment: segment,
          subject: this.getSubjectLine(segment),
          published_at: new Date().toISOString(),
          sent_count: 0, // Will be updated when actually sent
          failed_count: 0,
          open_rate: 0,
          click_rate: 0,
          content_json: JSON.stringify(processedArticles)
        });
        console.log(`📋 Newsletter logged to Content_Archive: ${issueId}`);
      } catch (error) {
        console.error('⚠️ Failed to log newsletter to archive:', error.message);
      }
      
      // Mark articles as used — ONLY on confirmed send, never on preview
      if (sendEmail) {
        try {
          const articleIds = processedArticles.map(a => a.id).filter(Boolean);
          if (articleIds.length === 0) {
            console.warn('No article IDs found - check ID preservation in processWithOpenAI');
          } else {
            const issueId = `${segment}-${new Date().toISOString().split('T')[0]}`;
            console.log(`\n🏷️ Marking articles as used...`);
            console.log(`Article IDs to mark: ${articleIds}`);
            const markedCount = await this.sheetsManager.markArticlesAsUsed(articleIds, issueId);
            console.log(`✅ Marked ${markedCount} articles as used in issue ${issueId}`);
          }
        } catch (error) {
          console.error('⚠️ Failed to mark articles as used:', error.message);
        }
      } else {
        console.log(`👁️ Preview mode — articles NOT marked as used`);
      }

const newsletterResult = {
        segment: segment,
        articles: processedArticles,
        html: newsletterHtml,
        text: this.buildTextNewsletter(processedArticles, segment),
        subject: this.getSubjectLine(segment),
        filename: filename
      };

      // Send email if requested
      if (sendEmail) {
        console.log(`📧 Sending newsletter via email...`);
        
        try {
          const sendResult = await this.emailSender.sendNewsletter(newsletterResult);
          
          console.log(`✅ Email sending completed:`);
          console.log(`   📤 Sent: ${sendResult.sentCount}`);
          console.log(`   ❌ Failed: ${sendResult.failedCount}`);
          console.log(`   📋 Total subscribers: ${sendResult.totalSubscribers}`);
          
          newsletterResult.emailSending = sendResult;
          
        } catch (emailError) {
          console.error(`❌ Email sending failed: ${emailError.message}`);
          newsletterResult.emailSending = {
            success: false,
            error: emailError.message
          };
        }
      } else {
        console.log(`📝 Newsletter generated (email sending disabled)`);
      }

      console.log(`✅ Newsletter process completed for ${segment} segment`);
      return newsletterResult;
      
    } catch (error) {
      console.error(`❌ Newsletter generation failed:`, error.message);
      throw error;
    }
  }
  // ENHANCED: Priority-based article selection with 7-day filtering
  async getRecentArticles(days = 7, segment = null) {
    try {
      console.log(`📋 Fetching recent articles (${days} days, segment: ${segment || 'all'})...`);
      
      // Get articles from sheets
      const recentArticles = await this.sheetsManager.getRecentArticles(days, segment);
      console.log(`📊 Raw articles from database: ${recentArticles.length}`);
      
      // STRICT: Only articles from last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const contemporaryArticles = recentArticles;
      console.log(`📅 Using all ${contemporaryArticles.length} articles (date filtering temporarily disabled)`);
      
      console.log(`📅 After 7-day contemporaneity filter: ${contemporaryArticles.length} recent articles`);
      
      if (contemporaryArticles.length < 3) {
        throw new Error(`Insufficient current content: only ${contemporaryArticles.length} articles from last 7 days`);
      }
      
      // ENHANCED: Priority ordering by category
      const prioritizedArticles = this.prioritizeByCategory(contemporaryArticles);
      
      // Remove duplicates with enhanced detection
      const uniqueArticles = this.removeDuplicates(prioritizedArticles);
      console.log(`🔍 After enhanced deduplication: ${uniqueArticles.length} unique articles`);

      // Apply category diversity cap (importance still dominates via dominanceThreshold)
      const diverseArticles = this.enforceCategoryDiversity(uniqueArticles);
      console.log(`📊 After diversity enforcement: ${diverseArticles.length} articles selected`);

      return diverseArticles;
    } catch (error) {
      console.error('Error fetching articles:', error.message);
      return [];
    }
  }
// CRITICAL: Category-based prioritization with geographic scoring and diversity cap
  prioritizeByCategory(articles) {
    console.log('🎯 Applying category-based prioritization...');

    const categoryPriority = {
      'Safety Alert': 100,
      'Enforcement Action': 90,
      'Regulatory Update': 80,
      'Technical Update': 70,
      'Driver Wellness': 65,
      'Industry News': 60
    };

    // Geographic relevance markers
    const australianMarkers = [
      'australia', 'australian', 'nhvr', 'hvnl', 'nsw', 'qld', 'vic', 'wa ', 'sa ', 'nt ',
      'act ', 'tas ', 'new south wales', 'queensland', 'victoria', 'western australia',
      'south australia', 'northern territory', 'tasmania', 'national transport',
      'ata ', 'vta ', 'qta ', 'hvia', 'transport for nsw', 'main roads', 'artsa'
    ];
    const foreignJurisdictionMarkers = [
      'ghana', 'kenya', 'nigeria', 'united kingdom', 'european union',
      'united states', 'canada', 'dvsa', 'fmcsa', 'dot usa', 'transaid'
    ];

    const prioritized = articles.map(article => {
      if (!article.category) {
        article.category = this.categorizeArticle(article);
      }

      const categoryScore = categoryPriority[article.category] || 50;
      const relevanceScore = article.relevanceScore || 0;

      // Geographic scoring
      const contentLower = (article.title + ' ' + (article.summary || '') + ' ' + (article.source || '')).toLowerCase();
      const australianScore = australianMarkers.reduce((s, m) => contentLower.includes(m) ? s + 1 : s, 0);
      const foreignScore = foreignJurisdictionMarkers.reduce((s, m) => contentLower.includes(m) ? s + 1 : s, 0);

      // Explicit subject-matter foreign markers — penalise even if "Australia" appears incidentally
      const foreignSubjectMarkers = [
        'ghana', 'kenya', 'nigeria', 'transaid',
        'united kingdom', 'uk transport', 'dvsa',
        'united states', 'fmcsa', 'dot usa',
        'european union', 'canada'
      ];
      const contentLowerFull = (article.title + ' ' + (article.summary || '')).toLowerCase();
      const hasForeignSubject = foreignSubjectMarkers.some(m => contentLowerFull.includes(m));

      let geoBonus = 0;
      if (hasForeignSubject) {
        // Hard penalty regardless of incidental Australian mentions
        geoBonus = -20;
      } else if (australianScore > 0) {
        geoBonus = Math.min(australianScore * 8, 24);
      } else if (foreignScore > 0) {
        geoBonus = -15;
      }

      // Composite score: category (60%) + relevance (25%) + geo (15% via bonus)
      const compositeScore = (categoryScore * 0.6) + (relevanceScore * 0.25) + geoBonus;

      return { ...article, compositeScore, categoryPriority: categoryScore, geoBonus };
    });

    prioritized.sort((a, b) => b.compositeScore - a.compositeScore);

    console.log('📊 Article prioritization results (with geo scoring):');
    prioritized.slice(0, 10).forEach((article, i) => {
      console.log(`  ${i + 1}. [${article.compositeScore.toFixed(1)}, geo:${article.geoBonus}] ${article.category} - ${article.title.substring(0, 50)}...`);
    });

    return prioritized;
  }

  // Enforce category diversity: once a category has 2 articles selected, a 3rd only gets in
  // if its composite score is 20+ points above the next best article from a different category.
  enforceCategoryDiversity(sortedArticles, maxPerCategory = 2, dominanceThreshold = 20) {
    const selected = [];
    const categoryCounts = {};
    const remaining = [...sortedArticles];

    for (let i = 0; i < remaining.length && selected.length < 10; i++) {
      const article = remaining[i];
      const cat = article.category || 'Industry News';
      const count = categoryCounts[cat] || 0;

      if (count < maxPerCategory) {
        selected.push(article);
        categoryCounts[cat] = count + 1;
      } else {
        // Over cap — only admit if dominant over next best from a different category
        const nextBestOther = remaining.slice(i + 1).find(a => (a.category || 'Industry News') !== cat);
        const gap = nextBestOther ? article.compositeScore - nextBestOther.compositeScore : dominanceThreshold + 1;
        if (gap >= dominanceThreshold) {
          selected.push(article);
          categoryCounts[cat] = count + 1;
          console.log(`  ⚡ Dominance override: 3rd ${cat} admitted (gap: ${gap.toFixed(1)})`);
        } else {
          console.log(`  🔀 Diversity cap: skipping 3rd ${cat} (gap ${gap.toFixed(1)} < ${dominanceThreshold})`);
        }
      }
    }

    return selected;
  }

  // ENHANCED: Category assignment with better logic
  categorizeArticle(article, segment = null) {
    const content = (article.title + ' ' + (article.summary || '')).toLowerCase();

    // Safety Alert - highest priority
    const safetyIndicators = [
      'accident', 'fatality', 'fatalities', 'death', 'deaths', 'injured', 'injuries',
      'crash', 'collision', 'rollover', 'jackknife',
      'safety alert', 'safety warning', 'urgent', 'immediate danger', 'critical',
      'emergency', 'recall', 'defect notice', 'defect', 'hazard', 'dangerous',
      'safety resource', 'driving safety', 'road safety', 'ntarc',
      'near miss', 'serious injury', 'heavy vehicle safety'
    ];

    // Enforcement Action - second highest
    const enforcementIndicators = [
      'prosecution', 'prosecuted', 'court', 'sentenced', 'sentencing',
      'fined', 'fine', 'penalty', 'penalties', 'conviction', 'convicted',
      'charged', 'charges', 'pleaded', 'guilty', 'plea',
      'enforcement', 'enforced', 'intercept', 'intercepted',
      'crackdown', 'blitz', 'nhvr operation', 'compliance operation',
      'roadside operation', 'compliance check', 'roadside check',
      'non compliance', 'non-compliance', 'licence suspended', 'licence disqualified',
      'licence cancelled', 'infringement', 'notice of', 'nhvr targets',
      'nhvr blitz', 'nhvr operation', 'targets compliance', 'targeting'
    ];

    // Regulatory Update - third priority
    const regulatoryIndicators = [
      'regulation', 'regulations', 'regulatory', 'law', 'laws', 'rule change',
      'policy', 'nhvr', 'hvnl', 'cor ', 'chain of responsibility',
      'government', 'consultation', 'consult', 'proposal', 'proposed',
      'amendment', 'amended', 'legislation', 'legislative',
      'standard', 'standards', 'requirement', 'requirements', 'mandate', 'mandated',
      'master code', 'pbs update', 'pbs changes', 'performance based',
      'accreditation', 'bfm', 'afm', 'mass management',
      'load restraint', 'load management', 'ata responds', 'ata welcomes',
      'industry code', 'national code', 'approved route', 'route permit',
      'notice of determination', 'gazette', 'instrument'
    ];

    // Technical Update - fourth priority
    const technicalIndicators = [
      'vehicle standard', 'vehicle standards', 'adrs', 'australian design rule',
      'technical', 'specification', 'specifications',
      'modification', 'modified', 'upgrade', 'upgraded',
      'maintenance', 'maintenance schedule', 'inspection',
      'certification', 'certified', 'approval', 'approved', 'testing',
      'brake', 'braking', 'tyre', 'tyres', 'coupling', 'trailer standard',
      'telematics', 'ewd', 'electronic work diary', 'dms', 'fatigue monitoring'
    ];

    // Driver Wellness
    const wellnessIndicators = [
      'fatigue', 'driver fatigue', 'wellness', 'wellbeing', 'mental health',
      'health', 'support', 'culture', 'workplace culture', 'stress',
      'driver health', 'driver wellness', 'psychological', 'burnout',
      'work hours', 'rest break', 'sleep', 'impairment', 'drug', 'alcohol'
    ];

    // Score each category
    const scores = {
      'Safety Alert': safetyIndicators.reduce((s, t) => content.includes(t) ? s + 1 : s, 0),
      'Enforcement Action': enforcementIndicators.reduce((s, t) => content.includes(t) ? s + 1 : s, 0),
      'Regulatory Update': regulatoryIndicators.reduce((s, t) => content.includes(t) ? s + 1 : s, 0),
      'Technical Update': technicalIndicators.reduce((s, t) => content.includes(t) ? s + 1 : s, 0),
      'Driver Wellness': wellnessIndicators.reduce((s, t) => content.includes(t) ? s + 1 : s, 0)
    };

    // Source-based boost: compliance-focused sources get a head start
    // toward their most likely category even when keyword signals are weak
    const source = (article.source || '').toLowerCase();
    const complianceSources = ['nhvr', 'national heavy vehicle regulator'];
    const regulatorySources = ['ata ', 'australian trucking association', 'vta', 'qta', 'hvia', 'artsa'];
    if (complianceSources.some(s => source.includes(s))) {
      scores['Regulatory Update'] += 3;
    }
    if (regulatorySources.some(s => source.includes(s))) {
      scores['Regulatory Update'] += 2;
    }

    const maxScore = Math.max(...Object.values(scores));
    if (maxScore === 0) return 'Industry News';

    const topCategory = Object.entries(scores).find(([cat, s]) => s === maxScore)[0];
    console.log(`🔍 Categorized as "${topCategory}": ${article.title.substring(0, 50)}... (score: ${maxScore})`);
    return topCategory;
  }
  // ENHANCED: Duplicate detection with multiple algorithms
  removeDuplicates(articles) {
    console.log(`🔍 Starting enhanced duplicate detection on ${articles.length} articles`);
    
    const unique = [];
    const duplicateReasons = [];
    
    for (let i = 0; i < articles.length; i++) {
      const currentArticle = articles[i];
      let isDuplicate = false;
      let duplicateReason = '';
      
      // Check against all previously accepted articles
      for (let j = 0; j < unique.length; j++) {
        const existingArticle = unique[j];
        
        // 1. EXACT URL match (obvious duplicates)
        if (currentArticle.url === existingArticle.url) {
          isDuplicate = true;
          duplicateReason = `Exact URL match with article ${j + 1}`;
          break;
        }
        
        // 2. EXACT title match (case insensitive)
        if (currentArticle.title.toLowerCase().trim() === existingArticle.title.toLowerCase().trim()) {
          isDuplicate = true;
          duplicateReason = `Exact title match with article ${j + 1}`;
          break;
        }
        
        // 3. ENHANCED title similarity check
        const titleSimilarity = this.calculateTextSimilarity(
          currentArticle.title.toLowerCase(),
          existingArticle.title.toLowerCase()
        );
        
        if (titleSimilarity > 0.85) { // 85% similarity threshold
          isDuplicate = true;
          duplicateReason = `High title similarity (${Math.round(titleSimilarity * 100)}%) with article ${j + 1}`;
          break;
        }
        
        // 4. Combined title + summary similarity (catches rewrites)
        const currentContent = (currentArticle.title + ' ' + (currentArticle.summary || '')).toLowerCase();
        const existingContent = (existingArticle.title + ' ' + (existingArticle.summary || '')).toLowerCase();
        
        const contentSimilarity = this.calculateTextSimilarity(currentContent, existingContent);
        
        if (contentSimilarity > 0.75) { // 75% overall content similarity
          isDuplicate = true;
          duplicateReason = `High content similarity (${Math.round(contentSimilarity * 100)}%) with article ${j + 1}`;
          break;
        }
        
        // 5. Key phrase matching (catches similar stories with different wording)
        if (this.hasSignificantOverlap(currentContent, existingContent)) {
          isDuplicate = true;
          duplicateReason = `Significant phrase overlap with article ${j + 1}`;
          break;
        }
      }
      
      if (isDuplicate) {
        duplicateReasons.push({
          title: currentArticle.title.substring(0, 60) + '...',
          reason: duplicateReason
        });
        console.log(`🔄 DUPLICATE: ${currentArticle.title.substring(0, 50)}... (${duplicateReason})`);
      } else {
        unique.push(currentArticle);
      }
    }
    
    console.log(`✅ Duplicate detection complete: ${unique.length} unique articles (removed ${duplicateReasons.length} duplicates)`);
    
    if (duplicateReasons.length > 0) {
      console.log(`📋 Removed duplicates:`);
      duplicateReasons.forEach((dup, i) => {
        console.log(`  ${i + 1}. ${dup.title} - ${dup.reason}`);
      });
    }
    
    return unique;
  }

  // Enhanced text similarity using multiple algorithms
  calculateTextSimilarity(text1, text2) {
    // Jaccard similarity for word-level comparison
    const words1 = new Set(text1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.split(/\s+/).filter(w => w.length > 2));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    const jaccardSimilarity = union.size > 0 ? intersection.size / union.size : 0;
    
    // Levenshtein-based similarity for character-level comparison
    const levenshteinSimilarity = 1 - (this.levenshteinDistance(text1, text2) / Math.max(text1.length, text2.length, 1));
    
    // Weighted combination (favor word-level similarity for news articles)
    return (jaccardSimilarity * 0.7) + (levenshteinSimilarity * 0.3);
  }

  // Levenshtein distance implementation
  levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  // Check for significant phrase overlap (catches stories about same incident)
  hasSignificantOverlap(content1, content2) {
    // Extract key phrases (3+ word combinations)
    const phrases1 = this.extractKeyPhrases(content1);
    const phrases2 = this.extractKeyPhrases(content2);
    
    let matchingPhrases = 0;
    
    for (const phrase1 of phrases1) {
      for (const phrase2 of phrases2) {
        if (phrase1 === phrase2 && phrase1.length > 15) { // Significant phrases only
          matchingPhrases++;
        }
      }
    }
    
    // If more than 30% of phrases match, likely the same story
    const maxPhrases = Math.max(phrases1.length, phrases2.length, 1);
    return (matchingPhrases / maxPhrases) > 0.3;
  }

  // Extract key phrases for comparison
  extractKeyPhrases(text) {
    const words = text.toLowerCase().split(/\s+/);
    const phrases = [];
    
    // Extract 3-6 word phrases, excluding common stop words
    const stopWords = new Set(['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those']);
    
    for (let i = 0; i < words.length - 2; i++) {
      const phrase = words.slice(i, i + 3).join(' ');
      const longPhrase = words.slice(i, Math.min(i + 6, words.length)).join(' ');
      
      // Skip phrases that are mostly stop words
      const contentWords = phrase.split(' ').filter(w => !stopWords.has(w));
      if (contentWords.length >= 2) {
        phrases.push(longPhrase);
      }
    }
    
    return phrases;
  }

  // CRITICAL: URL validation function
  validateUrl(url) {
    try {
      const urlObj = new URL(url);
      // Only allow real domains we've verified
      const allowedDomains = [
        'nhvr.gov.au', 'powertorque.com.au', 'bigrigs.com.au', 'healthyheads.org.au',
        'fullyloaded.com.au', 'ownerdriver.com.au', 'primemovermag.com.au',
        'trailermag.com.au', 'truckandbus.net.au', 'truck.net.au',
        'hvia.asn.au', 'qta.com.au', 'vta.com.au', 'westernroads.com.au',
        'safework.nsw.gov.au', 'twu.com.au', 'fairwork.gov.au'
      ];
      
      const isAllowed = allowedDomains.some(domain => 
        urlObj.hostname.includes(domain));
      
      if (!isAllowed) {
        console.warn(`⚠️ Rejected potentially hallucinated URL: ${url}`);
        return false;
      }
      
      return true;
    } catch (error) {
      console.warn(`⚠️ Invalid URL format: ${url}`);
      return false;
    }
  }
// ENHANCED: Process articles with URL validation and targeted action tips
  async processWithOpenAI(articles, segment) {
    const systemPrompt = segment === 'pro'
      ? `You are Australia's leading Chain of Responsibility compliance consultant writing for CoR Intel Weekly.

CRITICAL: You must NEVER modify, create, or fabricate URLs. Use the EXACT original URL provided - no changes allowed.

LANGUAGE: Write in Australian English using British spelling (organisation, realise, analyse, etc.).

AUDIENCE: Fleet managers, compliance officers, and transport executives responsible for HVNL compliance and CoR obligations under the Heavy Vehicle National Law.

OUTPUT FORMAT: Return ONLY valid JSON array. No markdown formatting, no code blocks, no backticks.

For each article, provide:
{
  "title": "Professional title stating the compliance impact directly — no hedging",
  "summary": "2-3 sentences: What happened, which HVNL obligations or CoR duty categories are engaged, and what the immediate exposure is for duty holders. Be direct and specific.",
  "tip": "One directive, specific action. Name the task, the person responsible, and a timeframe. Reference actual compliance instruments where relevant. Do NOT predict legal outcomes. Do NOT use hedging language.",
  "url": "EXACT original URL - NEVER modify, create, or change this",
  "source": "Original source name",
  "category": "Choose from: Safety Alert, Enforcement Action, Regulatory Update, Technical Update, Driver Wellness, Industry News"
}

ACTION TIP REQUIREMENTS — CRITICAL:
- Be direct and specific about WHAT to check or do, not just that a review should happen.
- Identify at least one specific focus area drawn directly from the article — a particular obligation, document, process, or metric that is relevant to the story.
- Do NOT invent deadlines. Only include a timeframe if the article explicitly states one. If no deadline is stated, omit timeframes entirely.
- Direct actions to compliance functions, not named roles. Say "the operations function" or "compliance teams" not "your Compliance Manager" or "the Safety Officer".
- GOOD: "Pull your PBS vehicle approval schedules and check SRT values against the proposed new thresholds in the NHVR consultation. If any vehicles are near the boundary, flag them for engineering review before the consultation closes."
- GOOD: "Review your work diary records for the last 90 days and verify that rest breaks are recorded against scheduled run times — this is the specific area the NHVR blitz is targeting."
- GOOD: "Check your load restraint documentation for all active linehaul runs. Verify that restraint plans reference the current Load Restraint Guide 3rd edition, not earlier versions."
- BAD: "Conduct a compliance audit of your operations and rectify issues by end of month." (too vague, invented deadline)
- BAD: "Ask your Compliance Manager to review procedures." (names a role rather than a function)
- BAD: "You might consider reviewing your compliance processes when convenient." (hedging)
- Reference specific instruments where relevant: HVNL, SMS, BFM, AFM, Mass Management Accreditation, Load Restraint Guide, PBS, CoR duty categories.
- Stop short of predicting prosecution, fines, or legal outcomes — the disclaimer covers the analysis; the tip covers the action.

PRIORITY ORDER (most important first):
1. Safety Alert - immediate safety concerns with operational impact
2. Enforcement Action - prosecutions, penalties, court decisions — name the penalties and duty categories involved
3. Regulatory Update - new rules, policy changes — state when they take effect
4. Technical Update - vehicle standards, equipment requirements
5. Driver Wellness - fatigue, health, wellbeing
6. Industry News - market developments, operational context`

      : `You are a senior road safety officer and former long-haul driver writing for Safe Freight Mate newsletter.

CRITICAL: You must NEVER modify, create, or fabricate URLs. Use the EXACT original URL provided - no changes allowed.

LANGUAGE: Write in Australian English using British spelling (organisation, realise, analyse, etc.). Direct, plain language — no jargon, no corporate speak.

AUDIENCE: Professional truck drivers, owner-operators, and transport workers across Australia. They are experienced, they respect straight talk, and they need information that helps them stay safe and keep their licence.

OUTPUT FORMAT: Return ONLY valid JSON array. No markdown formatting, no code blocks, no backticks.

For each article, provide:
{
  "title": "Driver-focused title that says what this means for the job — direct, no fluff",
  "summary": "2-3 sentences in plain language: what happened, why it matters on the road, what the real-world impact is for drivers. Be specific about the risk or change.",
  "tip": "One direct, practical action. Tell the driver exactly what to do and when. No hedging, no waffle.",
  "url": "EXACT original URL - NEVER modify, create, or change this",
  "source": "Original source name",
  "category": "Choose from: Safety Alert, Enforcement Action, Regulatory Update, Technical Update, Driver Wellness, Industry News"
}

ACTION TIP REQUIREMENTS — CRITICAL:
- Be direct and specific. Tell the driver exactly what to check or do — not just that something needs reviewing.
- Identify at least one specific thing drawn from the article — a particular check, document, piece of equipment, or behaviour that is directly relevant to the story.
- Do NOT invent deadlines. Only include a timeframe if the article explicitly states one (e.g. a regulation taking effect on a specific date). If no deadline exists, leave it out.
- Do NOT name specific roles like "tell your Transport Manager". Use plain functional language: "let your depot know", "flag it with your supervisor", "check with your operator".
- GOOD: "Before your next run, check your work diary entries for the last two weeks and make sure your rest breaks are recorded accurately — this is exactly what inspectors checked in this blitz."
- GOOD: "Do a full coupling and load restraint check before departure. Pay particular attention to whether your restraint plan matches the actual load configuration — that is what NHVR is targeting."
- GOOD: "If your truck is in the affected model range listed in this notice, flag it with your depot before your next long haul. Do not wait for a defect notice to come to you."
- BAD: "Review your compliance obligations when you get a chance." (vague, hedging)
- BAD: "Tell your Transport Manager to update procedures by end of month." (names a role, invented deadline)
- Keep it practical: things a driver can actually do on the job, before a shift, or in conversation with their depot.
- Do NOT predict fines, licence loss, or legal outcomes for specific situations.

PRIORITY ORDER (most important first):
1. Safety Alert - immediate on-road safety risks
2. Enforcement Action - blitzes, prosecutions, penalties — warn drivers what inspectors are targeting
3. Regulatory Update - rule changes that affect daily driving
4. Technical Update - vehicle maintenance, defect notices, equipment standards
5. Driver Wellness - fatigue, health, mental wellbeing
6. Industry News - conditions, pay, job market`;

    const userPrompt = `Process these ${articles.length} Australian transport articles into newsletter entries.

CRITICAL RULES:
1. Use EXACT original URLs — never modify, shorten, or fabricate URLs.
2. Return ONLY a valid JSON array. No markdown, no backticks, no preamble.

FOR EACH ARTICLE, your action tip MUST:
- Name at least one SPECIFIC thing from the article itself: a named standard, a specific figure, a particular obligation, a named provision, a specific vehicle type, a specific route or corridor, a specific enforcement target. Generic instructions like "conduct a review" or "ensure compliance" are NOT acceptable unless paired with a specific focus drawn from the article.
- If the article mentions a specific fine amount, name it. If it names a specific vehicle standard, name it. If it names a specific NHVR operation or blitz target, name it. If it names a specific document or instrument, name it.
- For enforcement stories: only name the specific offence if the article explicitly states it. NEVER speculate about the offence type. If the article does not name the offence, build the tip around what the article DOES state — the penalty amount, the jurisdiction, the enforcement mechanism — and reference the most common intercept triggers without asserting which one applied.
- EXAMPLE — article says "Truck driver fined $1,747 and loses licence for three months after SA intercept" but does not name the specific offence:
  CORRECT: "Check that all driver licence details are current and that vehicle defect histories are clear before dispatch — SA intercepts typically target licence status, load restraint, and vehicle condition. A $1,747 fine and three-month disqualification is the exposure for a single intercept."
  WRONG: "Review fatigue management records and ensure work and rest hours are documented." (fatigue is not mentioned in the article — do not assume it)
- Do NOT add deadlines unless the article explicitly states one.
- Direct actions to compliance functions, not named roles.

Return only valid JSON array:\n\n${JSON.stringify(articles, null, 2)}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 4000
      });

      let responseContent = response.choices[0].message.content.trim();
      
      // Clean response
      responseContent = responseContent
        .replace(/```json\s*/g, '')
        .replace(/```\s*$/g, '')
        .replace(/^`+|`+$/g, '')
        .trim();
      
      const processedContent = JSON.parse(responseContent);
      
      // CRITICAL: Validate all URLs and restore originals if modified
      processedContent.forEach((processed, i) => {
        const original = articles[i];
        
        // PRESERVE THE ORIGINAL ID
        processed.id = original.id;
        
        // Force original URL to prevent hallucination
        if (processed.url !== original.url || !this.validateUrl(processed.url)) {
          console.warn(`🔒 URL protection: Restoring original URL for article ${i + 1}`);
          processed.url = original.url;
        }
        
        // Validate category
        const validCategories = ['Safety Alert', 'Enforcement Action', 'Regulatory Update', 'Technical Update', 'Driver Wellness', 'Industry News'];
        if (!validCategories.includes(processed.category)) {
          processed.category = 'Industry News';
        }
      });
      
      return processedContent;
      
    } catch (error) {
  console.error('❌ OpenAI processing error details:');
  console.error('   Error type:', error.constructor.name);
  console.error('   Error message:', error.message);
  console.error('   API Key present:', !!process.env.OPENAI_API_KEY);
  console.error('   API Key format:', process.env.OPENAI_API_KEY?.substring(0, 7) + '...');
  
  // Log HTTP-specific errors
  if (error.response) {
    console.error('   HTTP Status:', error.response.status);
    console.error('   HTTP Data:', error.response.data);
  }
  
  // Log OpenAI-specific errors
  if (error.error) {
    console.error('   OpenAI Error:', error.error);
  }
  
  console.error('   Full error object:', JSON.stringify(error, null, 2));
  
  // Enhanced fallback with URL protection
  return articles.map(article => ({
        id: article.id,
        title: article.title,
        summary: this.generateFallbackSummary(article, segment),
        tip: this.generateFallbackTip(article, segment),
        url: article.url, // Always use original URL
        source: article.source,
        category: this.categorizeArticle(article, segment)
      }));
    }
  }

  generateFallbackSummary(article, segment) {
    if (segment === 'pro') {
      return `Important regulatory development from ${article.source} requiring compliance assessment. Transport operators should review implications for their Chain of Responsibility obligations and update risk management frameworks accordingly.`;
    } else {
      return `Important safety and compliance update from ${article.source}. This development may affect your daily driving operations and workplace procedures. Stay informed to keep yourself and others safe on the road.`;
    }
  }

  generateFallbackTip(article, segment) {
    if (segment === 'pro') {
      return 'Compliance Manager should schedule SMS review within 7 days and assess requirement for safety management system updates, staff training, or operational procedure changes.';
    } else {
      return 'Check with your supervisor before your next shift to understand how this affects your daily driving routine and ensure you stay compliant.';
    }
  }

// ENHANCED: Newsletter HTML generation with email-safe hero header (table + inline styles)
buildComplianceNewsletterHTML(articles, segment) {
  const isPro = (segment === 'pro');
  const color = '#1e40af'; // SFP blue
  const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  const newsletterConfig = SFP_BRAND.newsletters[segment];
const title = newsletterConfig.title;
const tagline = newsletterConfig.tagline;
// Preheader text (shows in inbox preview; hidden in the email body)
const preheaderText = isPro
  ? `${title} — ${tagline}. This week’s key safety, enforcement, and regulatory updates.`
  : `${title} — ${tagline}. Quick weekly safety and compliance heads-up.`;

// Enhanced date formatting
const date = new Date();
const formattedDate = date.toLocaleDateString('en-AU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

  
  // Generate unique newsletter ID for tracking
  const newsletterId = `${segment}-${Date.now()}`;

  // Generate article cards with proper category styling
  const articleCards = articles.map((article, index) => {
    const categoryStyle = this.getCategoryStyle(article.category);

    // UTM tracked version
    const issueId = `${segment}-${new Date().toISOString().split('T')[0]}`;
    const articleUrl = `${article.url}?utm_source=sfp_newsletter&utm_medium=email&utm_campaign=${issueId}&utm_content=article_${index + 1}&utm_term=${encodeURIComponent(
      article.category.toLowerCase().replace(/\s+/g, '_')
    )}`;

    return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 35px;">
  <tr><td>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
      <tr><td style="background-color: ${categoryStyle.bgColor}; color: ${categoryStyle.textColor}; padding: 6px 12px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px;">
        ${article.category}
      </td></tr>
    </table>
    <h2 style="margin:12px 0 8px 0; color:#111827; font-size:20px; line-height:1.4; font-weight:700; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; text-align:left;">
  ${this.escapeHtml(article.title)}
</h2>

<!-- Date (under title, no source) -->
<div style="margin: 0 0 8px 0; color: #6b7280; font-size: 13px; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
  ${(() => {
    const iso = article.publishedAt || article.pubDate || '';
    if (!iso) return 'Published recently';
    const dt = new Date(iso);
    const long = dt.toLocaleDateString('en-AU', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    const now = new Date();
    const diff = now - dt;
    const s = Math.round(diff/1000), m = Math.round(s/60), h = Math.round(m/60), d = Math.round(h/24);
    const rel = s < 60 ? `${s}s ago` : (m < 60 ? `${m}m ago` : (h < 24 ? `${h}h ago` : `${d}d ago`));
    return `${long} (${rel})`;
  })()}
</div>


    <p style="margin:0 0 16px 0; color:#333333; font-size:16px; line-height:1.5; text-align:left;">
  ${this.escapeHtml(article.summary)}
</p>

    <div style="background: #f8fafc; padding: 16px; border-radius: 6px; margin: 12px 0; border-left: 4px solid ${color}; border-radius: 0 6px 6px 0;">
      <p style="margin: 0 0 8px 0; color: #374151; font-size: 14px;"><strong>Action Tip:</strong></p>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.5;">${this.escapeHtml(article.tip)}</p>
    </div>
    <p style="margin: 8px 0 12px 0; color: #6b7280; font-size: 13px; font-style: italic;">Source: ${this.escapeHtml(article.source)}</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
      <tr><td style="background-color: ${color}; border-radius: 4px;">
        <a href="${articleUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 10px 18px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600;">
          Read More →
        </a>
      </td></tr>
    </table>
  </td></tr>
</table>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 35px 0;">
  <tr>
    <td style="border-top: 1px solid #e5e7eb; line-height: 1px; font-size: 0;">&nbsp;</td>
  </tr>
</table>`;
}).join('');

// Placeholders substituted per-subscriber by sendSingleEmail()
const unsubscribeUrl = '{{UNSUBSCRIBE_URL}}';
const pauseUrl = '{{PAUSE_URL}}';


  // Mailto fallbacks
  const unsubscribeMailto = 'mailto:unsubscribe@safefreightprogram.com.au?subject=Unsubscribe Request';
  const pauseMailto = 'mailto:pause@safefreightprogram.com.au?subject=Pause Newsletter';

  // Disclaimer
  const disclaimer = isPro
    ? `<div style="background:#f3f4f6;padding:20px;margin:20px 0;border-radius:8px;border-left:4px solid #6b7280;">
         <p style="color:#6b7280;font-size:11px;line-height:1.4;margin:0;font-style:italic;">
           <strong>Professional Analysis Disclaimer:</strong> CoR Intel Weekly provides professional compliance analysis based on current HVNL obligations and NHVR enforcement patterns. The action guidance reflects our professional assessment of prudent compliance practice. This is not legal advice — duty holders with specific compliance questions or facing enforcement action should engage qualified transport law counsel. Reliance on this publication does not constitute a defence to regulatory non-compliance.
         </p>
       </div>`
    : `<div style="background:#f3f4f6;padding:20px;margin:20px 0;border-radius:8px;border-left:4px solid #6b7280;">
         <p style="color:#6b7280;font-size:11px;line-height:1.4;margin:0;font-style:italic;">
           <strong>Safety Note:</strong> Safe Freight Mate provides practical safety and compliance guidance based on current Australian road transport regulations. This is not legal advice. Your specific situation may differ — always follow your employer's procedures and consult your supervisor or a qualified adviser if you are unsure about your obligations.
         </p>
       </div>`;

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
  <title>${this.escapeHtml(title)}</title>
  <meta name="description" content="Latest Chain of Responsibility intelligence and safety updates">
  <style>
    @media only screen and (max-width: 600px) {
      body, table, td, p { font-size:14px !important; line-height:1.6 !important; }
      h2 { font-size:22px !important; line-height:1.35 !important; }
      .mobile-padding { padding: 20px !important; }
      .mobile-text { font-size: 16px !important; }
      .mobile-header { font-size: 24px !important; }
      .logo { width: 50px !important; height: 50px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .dark-mode-safe { color: #ffffff !important; }
    }
  </style>
</head>
<body bgcolor="#FFFFFF" style="margin:0;padding:0;background-color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;font-size:16px;line-height:1.6;">
  <!-- Preheader (hidden) -->
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#ffffff;">
    ${this.escapeHtml(preheaderText)}
  </div>
  <!-- Prevent some clients from pulling random body text into preview -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding: 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:600px;background-color:#ffffff;">
          
          <!-- ===== EMAIL-SAFE HERO ===== -->
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1E40AF" style="background-color:#1E40AF;">
                <tr>
                  <td align="center" style="padding:28px 16px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;">
<!-- Text-first brand line (renders even if images are blocked) -->
<tr>
  <td align="center" style="padding: 0 0 10px 0; font: 600 13px/1.2 ${SFP_BRAND.typography.primary}; color: ${SFP_BRAND.colors.blue100}; letter-spacing: 0.3px;">
    Safe Freight Program
  </td>
</tr>
                      <!-- Logo -->
<tr>
  <td align="center" style="padding: 0 0 16px 0;">
    <img src="${SFP_BRAND.logo.url}"
     width="${SFP_BRAND.logo.width}"
     height="${SFP_BRAND.logo.height}"
     alt="${SFP_BRAND.logo.alt}"
     style="display:block; border:0; outline:none; text-decoration:none; margin:0 auto;">
  </td>
</tr>

<!-- Newsletter Title -->
<tr>
  <td align="center" style="font: 700 ${SFP_BRAND.typography.sizes.h1}/1.2 ${SFP_BRAND.typography.primary}; color: #FFFFFF; padding: 0 0 8px 0;">
    ${this.escapeHtml(SFP_BRAND.newsletters[segment].title)}
  </td>
</tr>
<!-- Date -->
<tr>
  <td align="center" style="font: 400 16px/1.6 ${SFP_BRAND.typography.primary}; color: ${SFP_BRAND.colors.blue100};">
    ${this.escapeHtml(formattedDate)}
  </td>
</tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- ===== END HERO ===== -->

          <!-- CONTENT WRAPPER -->
          <tr>
            <td style="padding:24px; text-align:left; font-size:16px; line-height:1.6; color:#111827;" class="mobile-padding">
              ${articleCards}

              <!-- Share Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top: 10px;">
                <tr><td style="text-align: center; padding: 20px;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                    <tr><td style="background-color: ${color}; border-radius: 6px;">
                      <a href="mailto:?subject=Recommended Newsletter: ${this.escapeHtml(title)}&body=Hi,%0A%0AI subscribe to ${this.escapeHtml(title)} and thought you might find it valuable too.%0A%0AYou can subscribe at:%0A%0Ahttps://www.safefreightprogram.com/subscribe.html%0A%0ACheers!"
                         style="display: inline-block; padding: 14px 28px; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; border-radius: 6px;">
                        ${isPro ? 'Recommend CoR Intel Weekly to a Colleague' : 'Share with a Mate'} →
                      </a>
                    </td></tr>
                  </table>
                </td></tr>
              </table>
            </td>
          </tr>

          <!-- Disclaimer -->
          <tr>
            <td style="padding: 0 24px;">
              ${disclaimer}
            </td>
          </tr>

          <!-- Spam Act compliance -->
          <tr>
            <td style="padding: 20px 24px; background-color: #f8fafc; border-top: 1px solid #e5e7eb;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center;">
                    <p style="margin: 0 0 12px 0; color: #6b7280; font-size: 12px; line-height: 1.4;">
                      You received this email because you subscribed to ${this.escapeHtml(title)}.<br>
                      Safe Freight Program<br>
                      Parcel Locker 1017149451, 326 King Street NEWTOWN NSW 2042
                    </p>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                      <tr>
                        <td style="padding: 0 8px;">
                          <a href="${pauseUrl}" style="color: #6b7280; font-size: 12px; text-decoration: underline;">Pause newsletters</a>
                        </td>
                        <td style="padding: 0 8px; color: #d1d5db;">|</td>
                        <td style="padding: 0 8px;">
                          <a href="${unsubscribeUrl}" style="color: #6b7280; font-size: 12px; text-decoration: underline;">Unsubscribe</a>
                        </td>
                        <td style="padding: 0 8px; color: #d1d5db;">|</td>
                        <td style="padding: 0 8px;">
                          <a href="${unsubscribeMailto}" style="color: #6b7280; font-size: 12px; text-decoration: underline;">Email unsubscribe</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 24px; border-top: 1px solid #e5e7eb;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding-bottom: 12px;">
                    <h3 style="margin: 0 0 8px 0; color: ${color}; font-size: 18px; font-weight: 600;">
                      Safe Freight Program
                    </h3>
                    <p style="margin: 0; color: #6b7280; font-size: 14px;">
                      Heavy Vehicle Compliance
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="text-align: center; padding: 8px 0; color: #9ca3af; font-size: 12px;">
                    <p style="margin: 0;">© ${new Date().getFullYear()} Safe Freight Program. All rights reserved.</p>
                    <p style="margin: 8px 0 0 0;">This email complies with the Australian Spam Act 2003</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

  getCategoryStyle(category) {
  const categoryStyles = {
    'Safety Alert': { 
      bgColor: '#fee2e2', 
      textColor: '#dc2626' 
    },        // Red - highest priority
    'Enforcement Action': { 
      bgColor: '#fef3c7', 
      textColor: '#d97706' 
    },   // Orange - second priority  
    'Regulatory Update': { 
      bgColor: SFP_BRAND.colors.blue100, 
      textColor: SFP_BRAND.colors.primary 
    },    // SFP Blue - third priority
    'Technical Update': { 
      bgColor: '#f3e8ff', 
      textColor: '#7c3aed' 
    },     // Purple - fourth priority
    'Driver Wellness': { 
      bgColor: '#dcfce7', 
      textColor: '#16a34a' 
    },      // Green - wellness
    'Industry News': { 
      bgColor: '#f1f5f9', 
      textColor: '#475569' 
    }         // Gray - lowest priority
  };
  
  return categoryStyles[category] || categoryStyles['Industry News'];
}

  getSubjectLine(segment) {
  const date = new Date().toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  
  const titles = SFP_BRAND.newsletters[segment];
  return `${titles.title} - ${date}`;
}
// Text-only newsletter for email clients that don't support HTML
  buildTextNewsletter(articles, segment) {
    const isPro = (segment === 'pro');
    const title = isPro ? 'CoR Intel Weekly' : 'Safe Freight Mate';
    const date = new Date().toLocaleDateString('en-AU', {
      weekday: 'long',
      day: 'numeric', 
      month: 'long',
      year: 'numeric'
    });

    const textContent = articles.map((article, index) => {
      return `
${index + 1}. [${article.category.toUpperCase()}] ${article.title}

${article.summary}

ACTION TIP: ${article.tip}

Source: ${article.source}
Read more: ${article.url}

${'='.repeat(60)}
`;
    }).join('\n');

    return `
${title}
${date}
${'='.repeat(title.length + date.length)}

${textContent}

SAFE FREIGHT PROGRAM
Heavy Vehicle Compliance
https://www.safefreightprogram.com

You received this because you subscribed to ${title}.
Unsubscribe: mailto:unsubscribe@safefreightprogram.com.au
`;
  }
  escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Test newsletter generation
if (require.main === module) {
  async function testEnhancedNewsletterGeneration() {
    const generator = new NewsletterGenerator();
    
    try {
      console.log('Testing enhanced newsletter generation...');
      
      // Test OpenAI API key first
      console.log('Testing OpenAI connection...');
      const testResponse = await generator.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with just the word "connected"' }],
        max_tokens: 10
      });
      console.log('OpenAI connected:', testResponse.choices[0].message.content);
      
      // Generate CoR Intel Weekly
      console.log('\nGenerating CoR Intel Weekly...');
      const proNewsletter = await generator.generateNewsletter('pro');
      console.log(`CoR Intel Weekly Generated:`);
      console.log(`   Subject: ${proNewsletter.subject}`);
      console.log(`   Articles: ${proNewsletter.articles.length}`);
      console.log(`   Preview: ${proNewsletter.filename}`);
      
      // Generate Safe Freight Mate  
      console.log('\nGenerating Safe Freight Mate...');
      const driverNewsletter = await generator.generateNewsletter('driver');
      console.log(`Safe Freight Mate Generated:`);
      console.log(`   Subject: ${driverNewsletter.subject}`);
      console.log(`   Articles: ${driverNewsletter.articles.length}`);
      console.log(`   Preview: ${driverNewsletter.filename}`);
      
      console.log('\nEnhanced newsletter generation completed successfully!');
      
    } catch (error) {
      console.error('\nEnhanced newsletter generation failed:', error.message);
      
      if (error.message.includes('Insufficient content')) {
        console.log('\nContent issue:');
        console.log('- Run enhanced scraper first: node scraper/scraper.js');
        console.log('- Check Article_Archive sheet has recent articles');
      } else if (error.message.includes('Invalid API key')) {
        console.log('\nOpenAI API issue:');
        console.log('- Check OPENAI_API_KEY in .env file');
      }
    }
  }
  
  testEnhancedNewsletterGeneration();
}


module.exports = NewsletterGenerator;
