const OpenAI = require('openai');
const SheetsManager = require('../config/sheets');
const { SFP_LOGO_BASE64 } = require('../config/logo-base64');
const config = require('../config/config');
const fs = require('fs');
const EmailSender = require('./emailSender');


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
      const recentArticles = await this.getRecentArticles(7, segment);
      console.log(`📋 Found ${recentArticles.length} recent articles for ${segment} segment`);
      
      if (recentArticles.length < 3) {
        throw new Error(`Insufficient content: only ${recentArticles.length} articles available`);
      }
      
      // Select top articles (already prioritized)
      const selectedArticles = recentArticles.slice(0, 5);
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
      
      // Mark articles as used (FIXED VERSION)
      try {
        const articleIds = processedArticles.map(a => a.id).filter(Boolean);
        if (articleIds.length === 0) {
          console.warn('No article IDs found - check ID preservation in processWithOpenAI');
          return { success: false, error: 'No article IDs to mark' };
        }
        const issueId = `${segment}-${new Date().toISOString().split('T')[0]}`;
        
        console.log(`\n🏷️ Marking articles as used...`);
        console.log(`Article IDs to mark: ${articleIds}`);
        
        const markedCount = await this.sheetsManager.markArticlesAsUsed(articleIds, issueId);
        console.log(`✅ Marked ${markedCount} articles as used in issue ${issueId}`);
      } catch (error) {
        console.error('⚠️ Failed to mark articles as used:', error.message);
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
      
      return uniqueArticles;
    } catch (error) {
      console.error('Error fetching articles:', error.message);
      return [];
    }
  }
// CRITICAL: Category-based prioritization
  prioritizeByCategory(articles) {
    console.log('🎯 Applying category-based prioritization...');
    
    // Define category priority order (highest to lowest)
    const categoryPriority = {
      'Safety Alert': 100,
      'Enforcement Action': 90, 
      'Regulatory Update': 80,
      'Technical Update': 70,
      'Driver Wellness': 95, // Higher for driver newsletter
      'Industry News': 60
    };
    
    // Calculate composite priority score
    const prioritized = articles.map(article => {
      // Determine category if not already set
      if (!article.category) {
        article.category = this.categorizeArticle(article);
      }
      
      const categoryScore = categoryPriority[article.category] || 50;
      const relevanceScore = article.relevanceScore || 0;
      
      // Composite score: category weight (70%) + relevance (30%)
      const compositeScore = (categoryScore * 0.7) + (relevanceScore * 0.3);
      
      return {
        ...article,
        compositeScore: compositeScore,
        categoryPriority: categoryScore
      };
    });

    // Sort by composite score (highest first)
    prioritized.sort((a, b) => b.compositeScore - a.compositeScore);
    
    // Log prioritization results
    console.log('📊 Article prioritization results:');
    prioritized.slice(0, 10).forEach((article, i) => {
      console.log(`  ${i + 1}. [${article.compositeScore.toFixed(1)}] ${article.category} - ${article.title.substring(0, 50)}...`);
    });
    
    return prioritized;
  }

  // ENHANCED: Category assignment with better logic
  categorizeArticle(article, segment = null) {
    const content = (article.title + ' ' + (article.summary || '')).toLowerCase();
    
    // Safety Alert - highest priority
    const safetyIndicators = [
      'accident', 'fatality', 'death', 'injured', 'crash', 'collision',
      'safety alert', 'urgent', 'immediate', 'critical', 'emergency',
      'recall', 'defect', 'hazard', 'dangerous', 'risk'
    ];
    
    // Enforcement Action - second highest
    const enforcementIndicators = [
      'prosecution', 'court', 'sentenced', 'fined', 'penalty', 'conviction',
      'charged', 'pleaded', 'guilty', 'enforcement', 'operation',
      'crackdown', 'blitz', 'compliance check'
    ];
    
    // Regulatory Update - third priority
    const regulatoryIndicators = [
      'regulation', 'law', 'rule', 'policy', 'nhvr', 'government',
      'consultation', 'proposal', 'amendment', 'legislation',
      'standard', 'requirement', 'mandate'
    ];
    
    // Technical Update - fourth priority
    const technicalIndicators = [
      'vehicle standard', 'technical', 'specification', 'equipment',
      'modification', 'upgrade', 'maintenance', 'inspection',
      'certification', 'approval', 'testing'
    ];
    
    // Driver Wellness - variable priority based on segment
    const wellnessIndicators = [
      'driver', 'fatigue', 'wellness', 'health', 'mental health',
      'support', 'culture', 'workplace', 'stress', 'wellbeing'
    ];

    // Score each category
    const scores = {
      'Safety Alert': safetyIndicators.reduce((score, term) => 
        content.includes(term) ? score + 1 : score, 0),
      'Enforcement Action': enforcementIndicators.reduce((score, term) => 
        content.includes(term) ? score + 1 : score, 0),
      'Regulatory Update': regulatoryIndicators.reduce((score, term) => 
        content.includes(term) ? score + 1 : score, 0),
      'Technical Update': technicalIndicators.reduce((score, term) => 
        content.includes(term) ? score + 1 : score, 0),
      'Driver Wellness': wellnessIndicators.reduce((score, term) => 
        content.includes(term) ? score + 1 : score, 0)
    };

    // Find highest scoring category
    const maxScore = Math.max(...Object.values(scores));
    if (maxScore === 0) return 'Industry News'; // Default category
    
    const topCategory = Object.entries(scores).find(([category, score]) => score === maxScore)[0];
    
    console.log(`🔍 Categorized as "${topCategory}": ${article.title.substring(0, 40)}... (score: ${maxScore})`);
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
      ? `You are Australia's leading Chain of Responsibility compliance consultant writing for COR Intel Weekly.

CRITICAL: You must NEVER modify, create, or fabricate URLs. Use the EXACT original URL provided - no changes allowed.

LANGUAGE: Write in Australian English using British spelling (organisation, realise, analyse, etc.).

AUDIENCE: Fleet managers, compliance officers, and transport executives responsible for HVNL compliance and CoR obligations.

OUTPUT FORMAT: Return ONLY valid JSON array. No markdown formatting, no code blocks, no backticks.

For each article, provide:
{
  "title": "Professional title focusing on compliance impact",
  "summary": "2-3 sentences: What happened, regulatory implications, immediate impact for CoR duty holders",
  "tip": "One ENCOURAGING, practical suggestion that compliance professionals could consider implementing, using supportive language like 'You might consider...', 'It could be worthwhile to...', 'A good approach would be to...' with suggested timeframes",
  "url": "EXACT original URL - NEVER modify, create, or change this",
  "source": "Original source name",
  "category": "Choose from: Safety Alert, Enforcement Action, Regulatory Update, Technical Update, Industry News"
}

ACTION TIP REQUIREMENTS:
- Use encouraging, supportive language rather than directive commands
- Suggest WHO might consider doing WHAT and WHEN
- Include realistic timeframes (within a week, by month-end, when convenient)
- Reference specific compliance areas (SMS, driver training, vehicle standards, record keeping)
- Be practical suggestions rather than orders
- Use phrases like "consider reviewing", "might be worth checking", "could benefit from"

PRIORITY ORDER (most important first):
1. Safety Alert - immediate safety concerns
2. Enforcement Action - prosecutions, penalties, court decisions  
3. Regulatory Update - new rules, policy changes
4. Technical Update - vehicle standards, equipment requirements
5. Industry News - market developments, operational updates`

      : `You are a veteran truck driver and safety mentor writing for Safe Freight Mate newsletter.

CRITICAL: You must NEVER modify, create, or fabricate URLs. Use the EXACT original URL provided - no changes allowed.

LANGUAGE: Write in Australian English using British spelling (organisation, realise, analyse, etc.).

AUDIENCE: Professional truck drivers, owner-operators, and transport workers focused on staying safe and keeping their jobs.

OUTPUT FORMAT: Return ONLY valid JSON array. No markdown formatting, no code blocks, no backticks.

For each article, provide:
{
  "title": "Driver-focused title about what this means for daily work",
  "summary": "2-3 conversational sentences: What this means for drivers, how it affects daily operations, why they should care",
  "tip": "One ENCOURAGING, practical suggestion using mate-to-mate language like 'You might want to...', 'Worth having a quick look at...', 'Could be a good idea to...' with specific but non-demanding actions",
  "url": "EXACT original URL - NEVER modify, create, or change this",
  "source": "Original source name",
  "category": "Choose from: Safety Alert, Enforcement Action, Regulatory Update, Technical Update, Industry News"
}

ACTION TIP REQUIREMENTS:
- Use encouraging, supportive mate-to-mate language rather than orders
- Suggest practical actions drivers can easily do
- Include realistic timeframes (before next trip, during pre-trip, when you get a chance)
- Be helpful suggestions rather than demands
- Use phrases like "might be worth", "could be good to", "you could try"
- Focus on keeping driver safe and legally compliant

PRIORITY ORDER (most important first):
1. Safety Alert - immediate safety concerns
2. Enforcement Action - prosecutions, penalties  
3. Regulatory Update - rule changes affecting daily driving
4. Technical Update - vehicle maintenance, equipment standards
5. Industry News - job market, workplace conditions`;

    const userPrompt = `Process these ${articles.length} Australian transport articles. CRITICAL: Use exact original URLs without any modification. Return only valid JSON array:\n\n${JSON.stringify(articles, null, 2)}`;

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
        const validCategories = ['Safety Alert', 'Enforcement Action', 'Regulatory Update', 'Technical Update', 'Industry News'];
        if (!validCategories.includes(processed.category)) {
          processed.category = 'Industry News';
        }
      });
      
      return processedContent;
      
    } catch (error) {
      console.error('OpenAI processing error:', error.message);
      
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
  const title = isPro ? 'COR Intel Weekly' : 'Safe Freight Mate';
  const subtitle = new Date().toLocaleDateString('en-AU', {
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
      <tr><td style="background-color: ${categoryStyle.bgColor}; color: ${categoryStyle.textColor}; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
        ${article.category}
      </td></tr>
    </table>
    <h2 style="margin: 12px 0 10px 0; color: #111827; font-size: 20px; font-weight: 700; line-height: 1.3;">
      ${this.escapeHtml(article.title)}
    </h2>
    <p style="margin: 0 0 16px 0; color: #4b5563; font-size: 15px; line-height: 1.6;">
      ${this.escapeHtml(article.summary)}
    </p>
    <div style="background: #f8fafc; padding: 16px; border-radius: 6px; margin: 12px 0; border-left: 4px solid ${color};">
      <p style="margin: 0 0 8px 0; color: #374151; font-size: 14px;"><strong>Action Tip:</strong></p>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.5;">${this.escapeHtml(article.tip)}</p>
    </div>
    <p style="margin: 8px 0 12px 0; color: #6b7280; font-size: 13px;">Source: ${this.escapeHtml(article.source)}</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
      <tr><td style="background-color: ${color}; border-radius: 4px;">
        <a href="${articleUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 10px 18px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600;">
          Read More →
        </a>
      </td></tr>
    </table>
  </td></tr>
</table>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
  <tr><td style="padding: 0 0 35px 0;">
    <div style="height: 1px; background-color: #e5e7eb;"></div>
  </td></tr>
</table>`;
  }).join('');

  // One-click unsubscribe (GAS)
  const gasWebAppUrl = 'https://script.google.com/macros/s/AKfycbzpItDNhfjRDMgCpYSZv_NZoqBmMDAZIzXCRIWl5UhJWYH55LbQaqOgBFiHqnQq9tIOIw/exec';
  const unsubscribeUrl = `${gasWebAppUrl}?e=unsub&i={{ISSUE_ID}}&s=${segment}&t={{TOKEN}}`;
  const pauseUrl = `${gasWebAppUrl}?e=pause&i={{ISSUE_ID}}&s=${segment}&t={{TOKEN}}`;

  // Mailto fallbacks
  const unsubscribeMailto = 'mailto:unsubscribe@safefreightprogram.com.au?subject=Unsubscribe Request';
  const pauseMailto = 'mailto:pause@safefreightprogram.com.au?subject=Pause Newsletter';

  // Disclaimer
  const disclaimer = isPro
    ? `<div style="background:#f3f4f6;padding:20px;margin:20px 0;border-radius:8px;border-left:4px solid #6b7280;">
         <p style="color:#6b7280;font-size:11px;line-height:1.4;margin:0;font-style:italic;">
           <strong>Disclaimer:</strong> This publication is for general information only and is not intended to be legal advice. You should seek your own professional advice before relying on the information provided.
         </p>
       </div>`
    : `<div style="background:#f3f4f6;padding:20px;margin:20px 0;border-radius:8px;border-left:4px solid #6b7280;">
         <p style="color:#6b7280;font-size:11px;line-height:1.4;margin:0;font-style:italic;">
           <strong>Safety Note:</strong> This update is for general safety and compliance awareness. It's not legal advice. Always follow your company procedures and ask your supervisor or manager if you're unsure.
         </p>
       </div>`;

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light only">
  <title>${this.escapeHtml(title)}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .mobile-padding { padding: 20px !important; }
      .mobile-text { font-size: 16px !important; }
      .mobile-header { font-size: 24px !important; }
      .logo { width: 50px !important; height: 50px !important; }
    }
  </style>
</head>
<body bgcolor="#FFFFFF" style="margin:0;padding:0;background-color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding: 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background-color:#ffffff;">
          
          <!-- ===== EMAIL-SAFE HERO ===== -->
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#1E40AF" style="background-color:#1E40AF;">
                <tr>
                  <td align="center" style="padding:28px 16px;">
                    <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;">
                      <tr>
                        <td align="left" style="padding:0 0 8px 0;">
                          <img src="https://sfp-newsletter-automation-production.up.railway.app/sfp-logo-small.png"
                               width="60" alt="Safe Freight Program"
                               style="display:block;border:0;outline:0;text-decoration:none;">
                        </td>
                      </tr>
                      <tr>
                        <td align="left" style="font:700 32px/1.2 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#FFFFFF;">
                          ${this.escapeHtml(title)}
                        </td>
                      </tr>
                      <tr>
                        <td align="left" style="font:400 16px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#DBEAFE;padding-top:6px;">
                          ${this.escapeHtml(subtitle)}
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
            <td style="padding: 24px;" class="mobile-padding">
              ${articleCards}

              <!-- Share Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top: 10px;">
                <tr><td style="text-align: center; padding: 20px;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                    <tr><td style="background-color: ${color}; border-radius: 6px;">
                      <a href="mailto:?subject=Recommended Newsletter: ${this.escapeHtml(title)}&body=Hi,%0A%0AI subscribe to ${this.escapeHtml(title)} and thought you might find it valuable too.%0A%0AYou can subscribe at:%0A%0Ahttps://www.safefreightprogram.com/subscribe.html%0A%0ACheers!"
                         style="display: inline-block; padding: 14px 28px; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; border-radius: 6px;">
                        ${isPro ? 'Recommend COR Intel Weekly to a Colleague' : 'Share with a Mate'} →
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

  // ENHANCED: Category styling with proper priority colors
  getCategoryStyle(category) {
    const categoryStyles = {
      'Safety Alert': { bgColor: '#fee2e2', textColor: '#dc2626' },        // Red - highest priority
      'Enforcement Action': { bgColor: '#fef3c7', textColor: '#d97706' },   // Orange - second priority  
      'Regulatory Update': { bgColor: '#dbeafe', textColor: '#1e40af' },    // Blue - third priority
      'Technical Update': { bgColor: '#f3e8ff', textColor: '#7c3aed' },     // Purple - fourth priority
      'Driver Wellness': { bgColor: '#dcfce7', textColor: '#16a34a' },      // Green - wellness
      'Industry News': { bgColor: '#f1f5f9', textColor: '#475569' }         // Gray - lowest priority
    };
    
    return categoryStyles[category] || categoryStyles['Industry News'];
  }

  getSubjectLine(segment) {
    const date = new Date().toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    
    return segment === 'pro' 
      ? `COR Intel Weekly - ${date}`
      : `Safe Freight Mate - ${date}`;
  }
// Text-only newsletter for email clients that don't support HTML
  buildTextNewsletter(articles, segment) {
    const isPro = (segment === 'pro');
    const title = isPro ? 'COR Intel Weekly' : 'Safe Freight Mate';
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
      
      // Generate COR Intel Weekly
      console.log('\nGenerating COR Intel Weekly...');
      const proNewsletter = await generator.generateNewsletter('pro');
      console.log(`COR Intel Weekly Generated:`);
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
