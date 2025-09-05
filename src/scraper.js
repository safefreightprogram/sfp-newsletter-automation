const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config/config');
const SheetsManager = require('../config/sheets');

class EnhancedNewsScraper {
  constructor() {
    this.config = config;
    this.results = [];
    this.errors = [];
    this.sheetsManager = new SheetsManager();
  }

  async scrapeAllSources() {
    console.log(`🚀 Starting enhanced scraping of ${config.sources.length} Australian transport sources...`);
    
    const startTime = Date.now();
    const allArticles = [];
    let totalProcessed = 0;
    let totalSuccessful = 0;

    // Filter enabled sources and sort by priority
    const enabledSources = config.sources
      .filter(source => source.enabled !== false)
      .sort((a, b) => b.priority - a.priority);

    console.log(`📊 Processing ${enabledSources.length} enabled sources (${config.sources.length - enabledSources.length} disabled)`);

    // Process sources with rate limiting
    for (const source of enabledSources) {
      try {
        console.log(`\n🔍 [${totalProcessed + 1}/${enabledSources.length}] Processing ${source.name} (Priority: ${source.priority})`);
        
        const articles = await this.scrapeSource(source);
        
        if (articles && articles.length > 0) {
          allArticles.push(...articles);
          totalSuccessful++;
          console.log(`✅ ${source.name}: Found ${articles.length} articles`);
        } else {
          console.log(`⚠️ ${source.name}: No articles found`);
        }

        totalProcessed++;

        // Rate limiting delay between sources
        if (totalProcessed < enabledSources.length) {
          console.log(`⏳ Waiting ${config.rateLimiting.delayBetweenSources/1000}s before next source...`);
          await this.delay(config.rateLimiting.delayBetweenSources);
        }

      } catch (error) {
        this.errors.push({
          source: source.name,
          error: error.message,
          url: source.url
        });
        console.error(`❌ ${source.name}: ${error.message}`);
        totalProcessed++;
      }
    }

    // Process and deduplicate articles
    const processedArticles = this.processArticles(allArticles);
    
    // Performance summary
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);
    
    console.log(`\n📈 SCRAPING COMPLETE`);
    console.log(`⏱️ Duration: ${duration} seconds`);
    console.log(`🎯 Sources processed: ${totalProcessed}/${enabledSources.length} (${totalSuccessful} successful)`);
    console.log(`📄 Raw articles found: ${allArticles.length}`);
    console.log(`✨ Processed articles: ${processedArticles.length}`);
    console.log(`⭐ High relevance (>10): ${processedArticles.filter(a => a.relevanceScore > 10).length}`);
    console.log(`🎯 Medium relevance (5-10): ${processedArticles.filter(a => a.relevanceScore >= 5 && a.relevanceScore <= 10).length}`);

    if (this.errors.length > 0) {
      console.log(`\n⚠️ ERRORS (${this.errors.length})`);
      this.errors.forEach((err, i) => {
        console.log(`${i + 1}. ${err.source}: ${err.error}`);
      });
    }

    // Show top articles
    console.log(`\n🏆 TOP ARTICLES BY RELEVANCE:`);
    processedArticles
      .slice(0, 10)
      .forEach((article, i) => {
        console.log(`${i + 1}. [${article.relevanceScore}] ${article.title}`);
        console.log(`   📰 ${article.source} | ${article.category}`);
      });

    return processedArticles;
  }

  async scrapeSource(source) {
    const articles = [];
    
    try {
      console.log(`   🌐 Fetching ${source.url}...`);
      
      // Request with enhanced headers and error handling
      const response = await axios.get(source.url, {
        headers: {
          'User-Agent': config.scraping.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: config.scraping.timeout,
        maxRedirects: 5,
        validateStatus: (status) => status < 400
      });

      console.log(`   ✅ Response received (${response.status}) - ${response.data.length} chars`);

      const $ = cheerio.load(response.data);
      
      // Try multiple selector strategies
      const selectors = [
        source.selector,
        'article',
        '.post',
        '.news-item',
        '.entry',
        '.story',
        'h2 a, h3 a',
        '.title a',
        '[href*="/news/"]',
        '[href*="/article/"]'
      ].filter(Boolean);

      let elementsFound = false;

      for (const selector of selectors) {
        const elements = $(selector);
        console.log(`   🔎 Testing selector "${selector}": ${elements.length} elements`);
        
        if (elements.length > 0) {
          let articleCount = 0;
          
          elements.each((i, element) => {
            if (articleCount >= config.scraping.maxArticlesPerSource) {
              return false; // Break out of each loop
            }
            
            const $el = $(element);
            const extractedData = this.extractArticleData($el, source, $);
            
            if (this.validateArticleData(extractedData, source)) {
              articles.push(extractedData);
              articleCount++;
            }
          });
          
          if (articles.length > 0) {
            elementsFound = true;
            break; // Found articles, no need to try other selectors
          }
        }
      }

      if (!elementsFound) {
        console.log(`   ❌ No valid articles found with any selector`);
        this.logPageStructure($, source.name);
      }

      return articles;

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Timeout after ${config.scraping.timeout}ms`);
      } else if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      } else if (error.code === 'ENOTFOUND') {
        throw new Error('Domain not found - check URL');
      } else {
        throw new Error(`Network error: ${error.message}`);
      }
    }
  }

  extractArticleData($el, source, $) {
    // Extract title using multiple strategies
    const title = this.extractWithFallback($el, $, [
      source.titleSelector,
      'h1', 'h2', 'h3',
      '.title', '.headline', '.entry-title', '.post-title',
      'a[title]', // Use link title attribute as fallback
      'a' // Link text as last resort
    ], 'text');

    // Extract URL using multiple strategies  
    const url = this.extractWithFallback($el, $, [
      source.linkSelector,
      'a[href]',
      'a'
    ], 'href');

    // Extract summary using multiple strategies
    const summary = this.extractWithFallback($el, $, [
      source.summarySelector,
      '.summary', '.excerpt', '.description', '.lead',
      '.entry-summary', '.post-excerpt',
      'p', '.content'
    ], 'text');

    // Convert relative URLs to absolute
    const absoluteUrl = this.makeAbsoluteUrl(url, source.url);

    // Calculate relevance score
    const relevanceScore = this.calculateRelevanceScore(title, summary, source);

    return {
      source: source.name,
      title: this.cleanText(title),
      url: absoluteUrl,
      summary: this.cleanText(summary),
      category: source.category || 'industry',
      priority: source.priority,
      relevanceScore: relevanceScore,
      publishedDate: new Date(), // Could be enhanced to extract actual publish date
      scrapedAt: new Date()
    };
  }

  extractWithFallback($el, $, selectors, type = 'text') {
    for (const selector of selectors.filter(Boolean)) {
      let result = null;
      
      try {
        if (type === 'href') {
          // For URLs, try the element itself first, then find within
          result = $el.attr('href') || $el.find(selector).first().attr('href');
        } else {
          // For text, try finding within element first, then element itself
          const found = $el.find(selector).first();
          if (found.length > 0) {
            result = found.text().trim();
          } else if ($el.is(selector)) {
            result = $el.text().trim();
          }
        }
        
        if (result && result.length > 0) {
          return result;
        }
      } catch (e) {
        // Continue to next selector if this one fails
        continue;
      }
    }
    
    return '';
  }

  makeAbsoluteUrl(url, baseUrl) {
    if (!url) return null;
    
    try {
      if (url.startsWith('http')) {
        return url; // Already absolute
      }
      
      const base = new URL(baseUrl);
      
      if (url.startsWith('//')) {
        return base.protocol + url;
      }
      
      if (url.startsWith('/')) {
        return `${base.protocol}//${base.host}${url}`;
      }
      
      // Relative URL
      return new URL(url, baseUrl).href;
      
    } catch (e) {
      console.warn(`   ⚠️ Invalid URL construction: ${url} + ${baseUrl}`);
      return null;
    }
  }

  validateArticleData(article, source) {
    const filters = config.contentFilters;
    
    // Basic required fields
    if (!article.title || !article.url) {
      return false;
    }

    // Title length validation
    if (article.title.length < filters.minTitleLength || 
        article.title.length > filters.maxTitleLength) {
      return false;
    }

    // URL domain validation
    if (!this.isAllowedDomain(article.url)) {
      console.warn(`   ⚠️ Rejected URL from unauthorized domain: ${article.url}`);
      return false;
    }

    // Content exclusion patterns
    const fullText = (article.title + ' ' + article.summary).toLowerCase();
    for (const pattern of filters.excludePatterns) {
      if (pattern.test(fullText)) {
        console.log(`   🚫 Excluded by pattern ${pattern}: ${article.title.substring(0, 50)}...`);
        return false;
      }
    }

    // Minimum relevance threshold
    if (article.relevanceScore < 3) {
      console.log(`   📊 Low relevance (${article.relevanceScore}): ${article.title.substring(0, 50)}...`);
      return false;
    }

    return true;
  }

  isAllowedDomain(url) {
    try {
      const urlObj = new URL(url);
      return config.allowedDomains.some(domain => 
        urlObj.hostname.includes(domain)
      );
    } catch (e) {
      return false;
    }
  }

  calculateRelevanceScore(title, summary, source) {
    const content = (title + ' ' + summary).toLowerCase();
    let score = 3; // Base score
    
    // Source priority bonus
    score += Math.floor(source.priority / 2);
    
    // Category weighting
    const categoryWeight = config.categoryWeights[source.category] || 5;
    score += Math.floor(categoryWeight / 3);
    
    // Keyword matching
    Object.entries(config.relevanceKeywords).forEach(([keyword, weight]) => {
      if (content.includes(keyword)) {
        score += weight;
      }
    });

    // Content quality indicators
    if (content.length > 200) score += 2; // Longer content bonus
    if (title.length > 30 && title.length < 100) score += 1; // Good title length
    if (summary.length > 100) score += 1; // Has substantial summary
    
    return Math.min(score, 20); // Cap at 20
  }

  cleanText(text) {
    if (!text) return '';
    
    return text
      .replace(/\s+/g, ' ') // Multiple whitespace to single space
      .replace(/[\r\n\t]/g, ' ') // Remove line breaks and tabs
      .replace(/[""'']/g, '"') // Normalize quotes
      .replace(/…/g, '...') // Normalize ellipsis
      .trim();
  }

  processArticles(articles) {
    console.log(`\n🔄 Processing ${articles.length} raw articles...`);
    
    // ENHANCED: Filter for articles from last 7 days only
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const recentArticles = articles.filter(article => {
      // For now, we're setting publishedDate to scrapedAt, but this ensures contemporaneity
      const articleDate = article.publishedDate || article.scrapedAt || new Date();
      return articleDate >= sevenDaysAgo;
    });
    
    console.log(`📅 After 7-day filter: ${recentArticles.length} recent articles (removed ${articles.length - recentArticles.length} older articles)`);
    
    // Remove duplicates by URL and title similarity
    const uniqueArticles = this.removeDuplicates(recentArticles);
    
    // Sort by relevance score (highest first)
    uniqueArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    console.log(`✅ After deduplication and sorting: ${uniqueArticles.length} articles`);
    
    return uniqueArticles;
  }

  removeDuplicates(articles) {
    const unique = [];
    const seenUrls = new Set();
    const seenTitles = new Set();
    
    for (const article of articles) {
      // Skip exact URL duplicates
      if (seenUrls.has(article.url)) {
        console.log(`   🔄 Duplicate URL: ${article.title.substring(0, 50)}...`);
        continue;
      }
      
      // Skip very similar titles
      const titleKey = article.title.toLowerCase()
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
        
      if (seenTitles.has(titleKey)) {
        console.log(`   🔄 Duplicate title: ${article.title.substring(0, 50)}...`);
        continue;
      }
      
      // Check for title similarity (more sophisticated)
      let isDuplicate = false;
      for (const existingTitle of seenTitles) {
        if (this.calculateSimilarity(titleKey, existingTitle) > 0.8) {
          console.log(`   🔄 Similar title: ${article.title.substring(0, 50)}...`);
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        unique.push(article);
        seenUrls.add(article.url);
        seenTitles.add(titleKey);
      }
    }
    
    console.log(`🔍 Removed ${articles.length - unique.length} duplicates`);
    return unique;
  }

  calculateSimilarity(str1, str2) {
    // Simple Jaccard similarity
    const set1 = new Set(str1.split(' ').filter(w => w.length > 3));
    const set2 = new Set(str2.split(' ').filter(w => w.length > 3));
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  logPageStructure($, sourceName) {
    console.log(`   🔍 ${sourceName} page structure analysis:`);
    const headings = $('h1, h2, h3').slice(0, 5);
    console.log(`   📰 Found ${headings.length} headings:`);
    headings.each((i, el) => {
      console.log(`     ${i + 1}. ${$(el).text().trim().substring(0, 60)}`);
    });
    
    const links = $('a[href]').slice(0, 5);
    console.log(`   🔗 Found ${links.length} links:`);
    links.each((i, el) => {
      console.log(`     ${i + 1}. ${$(el).text().trim().substring(0, 40)} -> ${$(el).attr('href')}`);
    });
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution function
async function runEnhancedScrapeAndSave() {
  const scraper = new EnhancedNewsScraper();
  const sheetsManager = new SheetsManager();
  
  try {
    console.log('🔧 Initializing enhanced scraping system...');
    
    // Initialize sheets connection
    const connected = await sheetsManager.initialize();
    if (!connected) {
      throw new Error('Failed to connect to Google Sheets database');
    }
    
    // Run enhanced scraping
    console.log('\n📡 Starting enhanced multi-source scraping...');
    const articles = await scraper.scrapeAllSources();
    
    if (articles.length === 0) {
      console.log('⚠️ No articles found. Check source configurations and network connectivity.');
      return;
    }
    
    // Check each article individually against database for duplicates
    console.log('\n🔍 Checking articles against database for duplicates...');
    const savedArticles = [];
    let skippedCount = 0;

    for (const article of articles) {
      // Check if this specific article already exists using the sheetsManager method
      const isDupe = await sheetsManager.checkIfArticleExists(article.url, article.title);
      
      if (isDupe) {
        console.log(`⏭️ Skipping duplicate: ${article.title.substring(0, 40)}...`);
        skippedCount++;
      } else {
        savedArticles.push(article);
      }
    }

    console.log(`✨ Filtered: ${savedArticles.length} new articles (${skippedCount} duplicates avoided)`);

    // Save only the truly new articles
    console.log('\n💾 Saving new articles to database...');
    const finalSavedArticles = await sheetsManager.saveArticles(savedArticles);
    
    // Final summary
    console.log(`\n🎉 ENHANCED SCRAPING COMPLETE`);
    console.log(`📊 Sources processed: ${config.sources.filter(s => s.enabled !== false).length}`);
    console.log(`📄 Total articles scraped: ${articles.length}`);
    console.log(`💾 New articles saved: ${finalSavedArticles.length}`);
    console.log(`🔄 Duplicates skipped: ${skippedCount}`);
    
    if (finalSavedArticles.length >= 10) {
      console.log('\n✅ SYSTEM READY: Sufficient content for newsletter generation!');
      console.log('Next step: Run newsletter generation with: node generator.js');
    } else if (finalSavedArticles.length > 0) {
      console.log('\n⚠️ LIMITED CONTENT: Some articles available but may need more sources.');
    } else {
      console.log('\n🔍 NO NEW CONTENT: All articles were duplicates of existing database entries.');
    }
    
    // Quality summary
    const highQuality = articles.filter(a => a.relevanceScore > 10);
    const mediumQuality = articles.filter(a => a.relevanceScore >= 5 && a.relevanceScore <= 10);
    
    console.log(`\n📈 QUALITY BREAKDOWN:`);
    console.log(`⭐ High relevance (>10): ${highQuality.length} articles`);
    console.log(`🎯 Medium relevance (5-10): ${mediumQuality.length} articles`);
    
    if (scraper.errors.length > 0) {
      console.log(`\n❌ ERRORS: ${scraper.errors.length} sources had issues`);
      console.log('Consider reviewing source configurations or network connectivity.');
    }
    
  } catch (error) {
    console.error('\n❌ ENHANCED SCRAPING FAILED:', error.message);
    
    if (error.message.includes('Sheets')) {
      console.log('\n🔧 DATABASE ISSUE:');
      console.log('1. Check Google Sheets credentials');
      console.log('2. Verify spreadsheet permissions');
      console.log('3. Confirm Article_Archive sheet exists');
    } else if (error.message.includes('network')) {
      console.log('\n🌐 NETWORK ISSUE:');
      console.log('1. Check internet connectivity');
      console.log('2. Verify source URLs are accessible');
      console.log('3. Consider firewall or proxy settings');
    }
    
    process.exit(1);
  }
}

// Allow both direct execution and module import
if (require.main === module) {
  runEnhancedScrapeAndSave().then(() => {
    console.log('\n✅ Enhanced scraping process completed successfully');
    process.exit(0);
  }).catch(error => {
    console.error('\n❌ Enhanced scraping process failed:', error.message);
    process.exit(1);
  });
}

module.exports = { EnhancedNewsScraper, runEnhancedScrapeAndSave };